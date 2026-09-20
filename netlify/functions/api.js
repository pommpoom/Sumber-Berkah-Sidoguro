const serverless = require('serverless-http');
const app = require('../../server/app');

exports.handler = serverless(app, {
  request(req) {
    // Rewrites preserve /api; direct Function URLs need the same Express prefix.
    req.url = req.url.replace(/^\/\.netlify\/functions\/api(?=\/|\?|$)/, '/api');
    // Use Netlify's client IP for the existing per-IP rate limits.
    const clientIp = req.headers['x-nf-client-connection-ip'];
    if (clientIp) {
      req.ip = clientIp;
      req.socket.remoteAddress = clientIp;
      delete req.headers['x-forwarded-for'];
    }
  }
});
