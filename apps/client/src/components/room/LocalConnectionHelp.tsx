"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { requestLocalAddressAccess } from "@/p2p/localAddressAccess";

export function LocalConnectionHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const retryWithPermission = async () => {
    setBusy(true);
    setError(null);
    try {
      await requestLocalAddressAccess(navigator.mediaDevices);
      window.location.reload();
    } catch (error) {
      setError(
        error instanceof Error && error.name === "NotAllowedError"
          ? "Microphone permission was not granted. You can still retry without it."
          : "The microphone could not be opened. Check this browser’s site permissions or retry without it."
      );
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Local connection help</DialogTitle>
          <DialogDescription>
            Keep both devices on the same Wi-Fi with this page open. Allow local network access for your browser, and
            check that the Wi-Fi permits devices to communicate.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            If local device names are blocked, optional microphone permission may let the browser use direct local
            addresses. It briefly opens your microphone, then immediately stops it. Microphone audio is never recorded
            or sent to anyone.
          </p>
          <p>
            This reloads the page and stops playback on this device. Saved music stays in your browser. The browser may
            remember microphone permission; you can revoke it in the site settings afterward. This does not bypass Wi-Fi
            isolation and may not solve every connection problem.
          </p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter className="sm:flex-col">
          <Button variant="outline" disabled={busy} onClick={() => window.location.reload()}>
            Retry without microphone
          </Button>
          <Button disabled={busy} onClick={retryWithPermission}>
            {busy ? "Waiting for microphone permission…" : "Allow microphone & reload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
