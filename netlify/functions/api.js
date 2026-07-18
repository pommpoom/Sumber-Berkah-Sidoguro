const serverless = require('serverless-http');
const app = require('../../server/app');

const handler = serverless(app);

exports.handler = (event, context) => {
  const functionPrefix = '/.netlify/functions/api';
  const path = event.path || event.rawPath || '';
  const normalizedPath = path.startsWith(functionPrefix) ? path.replace(functionPrefix, '/api') || '/api' : path;
  return handler({ ...event, path: normalizedPath, rawPath: normalizedPath }, context);
};
