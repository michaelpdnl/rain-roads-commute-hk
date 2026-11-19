'use strict';
const settings = require('/usr/src/node-red/node_modules/node-red/settings.js');
settings.flowFile = 'flows.json';
settings.uiPort = 1880;
settings.httpAdminRoot = '/red';
settings.httpStatic = '/opt/commute/web';
settings.credentialSecret = process.env.NODE_RED_CREDENTIAL_SECRET;
settings.functionGlobalContext = {city: require('/opt/commute/lib/service.cjs').get()};
module.exports = settings;
