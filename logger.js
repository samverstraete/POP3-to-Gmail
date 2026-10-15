"use strict";

const { existsSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const { createLogger, format, transports } = require("winston");
const DailyRotateFile = require("winston-daily-rotate-file");

const DEFAULT_LOG_DIR = path.normalize(process.env.LOG_DIR || "./logs");
if (!existsSync(DEFAULT_LOG_DIR)) {
  mkdirSync(DEFAULT_LOG_DIR, { recursive: true });
}

const logger = createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: format.combine(
    format.timestamp(),
    format.printf(({ timestamp, level, message, ...meta }) => {
      const details = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
      return `${timestamp} ${level.toUpperCase()}: ${message}${details}`;
    })
  ),
  transports: [
    new transports.Console(),
    new DailyRotateFile({
      dirname: DEFAULT_LOG_DIR,
      filename: "pop3_to_gmail-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      zippedArchive: true,
      maxSize: "20m",
      maxFiles: "14d",
    }),
  ],
  exitOnError: false,
});

logger.DEFAULT_LOG_DIR = DEFAULT_LOG_DIR;

module.exports = logger;
