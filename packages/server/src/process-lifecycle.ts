import type { FastifyInstance } from "fastify";

export interface ShutdownProcess {
  once(event: NodeJS.Signals, listener: () => void): unknown;
  off(event: NodeJS.Signals, listener: () => void): unknown;
  exit(code: number): never | void;
}

export const installGracefulShutdown = (
  app: Pick<FastifyInstance, "close">,
  processTarget: ShutdownProcess = process,
  log: (message: string) => void = console.log,
): (() => void) => {
  let draining = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (draining) return;
    draining = true;
    log(`Colonizt server received ${signal}; draining sockets and closing resources`);
    try {
      await app.close();
      processTarget.exit(0);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`Colonizt server failed to close cleanly: ${detail}`);
      processTarget.exit(1);
    }
  };
  const onTerm = () => void shutdown("SIGTERM");
  const onInterrupt = () => void shutdown("SIGINT");
  processTarget.once("SIGTERM", onTerm);
  processTarget.once("SIGINT", onInterrupt);
  return () => {
    processTarget.off("SIGTERM", onTerm);
    processTarget.off("SIGINT", onInterrupt);
  };
};
