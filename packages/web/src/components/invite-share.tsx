import { useState } from "react";
import { AccessibleDialog } from "./accessible-dialog.js";

export const InviteShare = ({
  code,
  url,
  onClose,
}: {
  code: string;
  url: string;
  onClose(): void;
}) => {
  const [message, setMessage] = useState(
    "Send this link to a friend, or share the room code.",
  );
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(url);
      setMessage("Invite copied. Your table is ready for company.");
    } catch {
      setMessage("Select the link below and copy it to invite your friend.");
    }
  };
  const share = async () => {
    try {
      await navigator.share({
        title: "Join my Colonizt table",
        text: `Room ${code}`,
        url,
      });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        await copy();
    }
  };
  return (
    <AccessibleDialog
      className="invite-dialog"
      label="Invite friends"
      onClose={onClose}
    >
      <div className="panel-title">
        <h2>Room for friends.</h2>
        <button aria-label="Close invite" onClick={onClose}>
          ×
        </button>
      </div>
      <span className="eyebrow">YOUR TABLE</span>
      <strong className="invite-code">{code}</strong>
      <p role="status">{message}</p>
      <label htmlFor="invite-url">Invite link</label>
      <input
        id="invite-url"
        readOnly
        value={url}
        onFocus={(e) => e.currentTarget.select()}
      />
      <div className="dialog-actions">
        {typeof navigator.share === "function" ? (
          <button onClick={() => void share()}>Share invite</button>
        ) : null}
        <button className="primary-button" onClick={() => void copy()}>
          Copy link
        </button>
      </div>
    </AccessibleDialog>
  );
};
