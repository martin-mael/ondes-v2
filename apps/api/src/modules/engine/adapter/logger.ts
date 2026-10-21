/** The subset of a pino/Fastify logger the adapter uses: `logger.warn(details, message)`. */
export type Logger = {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
  error(details: object, message: string): void;
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
