export const networkErrorMessage = (input: unknown): string => {
  const code = typeof input === "object" && input && "code" in input ? String((input as { code?: unknown }).code) : "";
  switch (code) {
    case "ROOM_NOT_FOUND":
      return "Room not found";
    case "ROOM_EXPIRED":
      return "Room expired";
    case "ROOM_ABANDONED":
      return "Room abandoned";
    case "ROOM_CLOSED":
      return "Room closed";
    case "ROOM_FULL":
      return "Room is full";
    case "ROOM_PAUSED":
      return "Room is paused";
    case "REPLAY_NOT_READY":
      return "Replay is available after the game is finished";
    case "REPLAY_FORBIDDEN":
      return "Replay is only available to players in this match";
    case "REPLAY_NOT_FOUND":
      return "Replay not found";
    case "RATE_LIMITED":
      return "Too many attempts. Try again shortly.";
    case "UNAUTHORIZED":
      return "Session expired";
    default:
      if (input instanceof Error) return input.message;
      if (typeof input === "object" && input && "message" in input && typeof (input as { message?: unknown }).message === "string") {
        return (input as { message: string }).message;
      }
      return code || "Online action failed";
  }
};
