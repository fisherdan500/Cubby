"use client";

import { useEffect } from "react";

function reportVisibleDocumentNavigation() {
  if (document.visibilityState !== "visible") return;
  void fetch("/api/account/session-activity", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestClass: "foreground_document_navigation" }),
    keepalive: true
  });
}

export function SessionActivityReporter() {
  useEffect(() => {
    reportVisibleDocumentNavigation();
  }, []);
  return null;
}
