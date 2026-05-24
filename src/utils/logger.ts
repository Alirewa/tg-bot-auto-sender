import * as fs from 'fs';
import * as path from 'path';
import { createLogger, format, transports, Logger } from 'winston';
import config from './config';

const LOG_DIR = path.resolve('./logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const consoleFormat = format.combine(
  format.colorize(),
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] ${level}: ${message}${metaStr}`;
  }),
);

const fileFormat = format.combine(format.timestamp(), format.json());

const logger: Logger = createLogger({
  level: config.logLevel,
  transports: [
    new transports.Console({ format: consoleFormat }),
    new transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      format: fileFormat,
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
    new transports.File({
      filename: path.join(LOG_DIR, 'combined.log'),
      format: fileFormat,
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
  ],
  exitOnError: false,
});

process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

export default logger;
