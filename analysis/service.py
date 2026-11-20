"""Internal FastAPI worker. Compose exposes no host port for this service."""
from threading import Lock

from fastapi import FastAPI, HTTPException

from .impact_model import compute
from .database import DatabaseUnavailable

app = FastAPI(title='Rain Roads original-method analytics', docs_url=None, redoc_url=None)
_compute_lock = Lock()


@app.get('/health')
async def health():
    # Independent async route stays responsive while compute runs in a worker thread.
    return {'ok': True, 'method': 'PLAN-v4 §8', 'busy': _compute_lock.locked()}


@app.post('/compute')
def compute_route(payload: dict):
    try:
        with _compute_lock:
            return compute(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except DatabaseUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
