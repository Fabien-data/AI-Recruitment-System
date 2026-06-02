const logger = require('../utils/logger');

module.exports = (err, req, res, next) => {
    // Log the error
    logger.error({
        message: err.message,
        stack: err.stack,
        url: req.url,
        method: req.method,
        ip: req.ip,
        body: req.body
    });

    // Default error status
    const statusCode = err.statusCode || err.status || 500;
    
    // Don't leak error details in production
    const message = process.env.NODE_ENV === 'production' && statusCode === 500
        ? 'Internal server error'
        : err.message;

    // `error` MUST be a string. Every route handler returns { error: 'string' }
    // and the entire frontend feeds response.data.error straight into
    // toast.error(...). Returning an object here makes react-hot-toast try to
    // render it as a React child, which throws and white-screens the whole app
    // (the <Toaster> is mounted at the root, outside any error boundary).
    res.status(statusCode).json({
        error: message,
        status: statusCode,
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
};
