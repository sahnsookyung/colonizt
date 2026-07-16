import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installGracefulShutdown, type ShutdownProcess } from "../src/process-lifecycle.js";

class FakeProcess extends EventEmitter implements ShutdownProcess {
  readonly exit = vi.fn((_code: number) => undefined);

  override once(event: NodeJS.Signals, listener: () => void): this {
    return super.once(event, listener);
  }

  override off(event: NodeJS.Signals, listener: () => void): this {
    return super.off(event, listener);
  }
}

describe("process lifecycle", () => {
  it("drains once across competing shutdown signals and reports the initiating signal", async () => {
    const target = new FakeProcess();
    const close = vi.fn(async () => undefined);
    const log = vi.fn();
    installGracefulShutdown({ close }, target, log);

    target.emit("SIGTERM");
    target.emit("SIGINT");
    await vi.waitFor(() => expect(target.exit).toHaveBeenCalledWith(0));

    expect(close).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("SIGTERM"));
  });

  it("returns a disposer that removes signal listeners", () => {
    const target = new FakeProcess();
    const close = vi.fn(async () => undefined);
    const dispose = installGracefulShutdown({ close }, target, vi.fn());
    dispose();
    target.emit("SIGTERM");
    expect(close).not.toHaveBeenCalled();
  });

  it("reports close failures and exits unsuccessfully", async () => {
    const target = new FakeProcess();
    const close = vi.fn(async () => Promise.reject(new Error("database close failed")));
    const log = vi.fn();
    installGracefulShutdown({ close }, target, log);

    target.emit("SIGINT");
    await vi.waitFor(() => expect(target.exit).toHaveBeenCalledWith(1));

    expect(close).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("database close failed"));
  });
});
