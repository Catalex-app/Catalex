import { useEffect, useState } from "react";
import { invoke } from "@/lib/desktop/core";
import { listen } from "@/lib/desktop/event";
import {
  GitCredentialDialog,
  type GitCredentialRequest,
} from "./git-credential-dialog";

export function GitCredentialRecovery() {
  const [requests, setRequests] = useState<GitCredentialRequest[]>([]);
  const remove = (id: string) =>
    setRequests((items) => items.filter((item) => item.id !== id));
  useEffect(() => {
    let disposed = false;
    const listeners = [
      listen<GitCredentialRequest>("git-credential-request", ({ payload }) => {
        if (!disposed)
          setRequests((items) =>
            items.some((item) => item.id === payload.id)
              ? items
              : [...items, payload],
          );
      }),
      listen<string>("git-credential-closed", ({ payload }) => {
        if (!disposed) remove(payload);
      }),
    ];
    return () => {
      disposed = true;
      for (const listener of listeners)
        void listener.then((unlisten) => unlisten());
    };
  }, []);
  const request = requests[0];
  if (!request) return null;
  return (
    <GitCredentialDialog
      key={request.id}
      request={request}
      onCancel={() => {
        void invoke("git_credential_respond", {
          id: request.id,
          username: null,
          token: null,
        })
          .finally(() => remove(request.id))
          .catch(() => {});
      }}
      onSubmit={async (username, token) => {
        await invoke("git_credential_respond", {
          id: request.id,
          username,
          token,
        });
        remove(request.id);
      }}
    />
  );
}
