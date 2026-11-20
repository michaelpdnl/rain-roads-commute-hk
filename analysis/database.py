"""Read-only, projected and chunked raw Mongo input for the internal worker/CLI."""
from datetime import datetime, timedelta, timezone
from itertools import islice
import os
import re

import pandas as pd

from .data import compact_source, progress, release_memory


class DatabaseUnavailable(RuntimeError):
    pass


def load_database(request):
    uri = os.environ.get('MONGO_URI', '')
    if not uri:
        raise DatabaseUnavailable('Mongo input unavailable: MONGO_URI is not configured.')
    database = request.get('database') or request.get('db') or os.environ.get('MONGO_DB', 'rain_roads')
    if not isinstance(database, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', database):
        raise ValueError('Invalid Mongo database name.')
    days = request.get('days', 90)
    if not isinstance(days, int) or isinstance(days, bool) or not 1 <= days <= 90:
        raise ValueError('days must be an integer between 1 and 90.')
    as_of = request.get('asOf')
    end = pd.Timestamp(as_of) if as_of else pd.Timestamp(datetime.now(timezone.utc))
    if end.tzinfo is None:
        raise ValueError('asOf must have an explicit timezone.')
    end = end.tz_convert('UTC')
    start = end - timedelta(days=days)
    stamp = lambda value: value.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    district = request.get('district') or 'all'
    from .impact_model import STUDY
    if district not in ('all', *STUDY):
        raise ValueError('district must be all or an original study district.')
    scope = {'d': {'$in': list(STUDY)} if district == 'all' else district,
             'ts': {'$gte': stamp(start), '$lte': stamp(end)}}

    def read_chunks(collection, projection):
        chunks = []
        total = 0
        with collection.find(scope, projection).batch_size(10000) as cursor:
            while batch := list(islice(cursor, 25000)):
                chunk = compact_source(pd.DataFrame.from_records(batch))
                total += len(chunk)
                chunks.append(chunk)
                del batch
                if total % 250000 == 0:
                    progress('mongo-read', observations=total)
        # Shared category sets prevent concat from expanding labels back to
        # millions of Python strings when a chunk happens to omit a detector.
        for name in ('id', 'd'):
            relevant = [chunk for chunk in chunks if name in chunk]
            if relevant:
                labels = sorted({label for chunk in relevant for label in chunk[name].cat.categories})
                for chunk in relevant:
                    chunk[name] = chunk[name].cat.set_categories(labels)
        result = pd.concat(chunks, ignore_index=True, copy=False) if chunks else pd.DataFrame()
        chunks.clear()
        release_memory()
        progress('mongo-read-complete', observations=len(result), dataBytes=int(result.memory_usage(deep=True).sum()))
        return result

    try:
        from pymongo import MongoClient
        with MongoClient(uri, serverSelectionTimeoutMS=10000) as client:
            progress('mongo-start')
            db = client[database]
            rows = read_chunks(db.traffic, {'_id': 0, 'id': 1, 'd': 1, 'ts': 1, 'speed': 1,
                                           'valid': 1, 'hasVehicles': 1, 'occupancy': 1})
            rain = read_chunks(db.district_rain, {'_id': 0, 'd': 1, 'ts': 1, 'mm': 1, 'publishedAt': 1,
                                                'fetchedAt': 1, 'source': 1, 'kind': 1, 'resolution': 1,
                                                'resolutionMinutes': 1})
    except Exception as error:
        # Credentials/connection strings are deliberately absent from API diagnostics.
        raise DatabaseUnavailable(f'Mongo raw input unavailable ({type(error).__name__}); no empty-data or alternate-statistics fallback.') from error
    return {'rows': rows, 'rain': rain, 'period': request.get('period', 'all')}, dict(
        storage='MongoDB', database=database, district=district, days=days, queryFrom=stamp(start), queryThrough=stamp(end))
