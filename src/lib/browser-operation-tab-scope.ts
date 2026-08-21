export type BrowserOperationTabScopeChannel = {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown): void;
  close(): void;
};

type BrowserOperationTabScopeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type BrowserOperationTabScopeOptions = {
  storage?: BrowserOperationTabScopeStorage;
  openChannel?: (name: string) => BrowserOperationTabScopeChannel | undefined;
  randomNonce?: () => string;
  claimTimeoutMs?: number;
};

export type BrowserOperationTabScope = {
  storageKey(partition: string, pointerKey: string): Promise<string>;
  close(): void;
};

type ClaimMessage = {
  version: 1;
  type: "probe" | "collision";
  namespace: string;
  claimant: string;
};

type ActiveClaim = {
  namespace: string;
  channel?: BrowserOperationTabScopeChannel;
};

const namespaceKey = (partition: string) => `cubby:browser-operation-tab-namespace:${partition}`;
const channelName = (partition: string) => `cubby:browser-operation-tab-claim:${partition}`;
const validNonce = /^[A-Za-z0-9_-]{8,128}$/;

function browserNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function browserChannel(name: string) {
  if (typeof BroadcastChannel !== "function") return undefined;
  return new BroadcastChannel(name);
}

function isClaimMessage(value: unknown): value is ClaimMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ClaimMessage>;
  return message.version === 1 &&
    (message.type === "probe" || message.type === "collision") &&
    typeof message.namespace === "string" && validNonce.test(message.namespace) &&
    typeof message.claimant === "string" && validNonce.test(message.claimant);
}

export function createBrowserOperationTabScope(options: BrowserOperationTabScopeOptions = {}): BrowserOperationTabScope {
  const randomNonce = options.randomNonce ?? browserNonce;
  const openChannel = options.openChannel ?? browserChannel;
  const claimTimeoutMs = options.claimTimeoutMs ?? 40;
  const claims = new Map<string, Promise<ActiveClaim>>();
  const activeChannels = new Set<BrowserOperationTabScopeChannel>();
  let closed = false;

  function currentStorage() {
    return options.storage ?? window.sessionStorage;
  }

  function retainedNamespace(partition: string) {
    try {
      const retained = currentStorage().getItem(namespaceKey(partition));
      return retained && validNonce.test(retained) ? retained : undefined;
    } catch {
      return undefined;
    }
  }

  function persistNamespace(partition: string, namespace: string) {
    try {
      currentStorage().setItem(namespaceKey(partition), namespace);
    } catch {
      // The in-memory namespace remains isolated for this document.
    }
  }

  async function resolveClaim(partition: string): Promise<ActiveClaim> {
    const retained = retainedNamespace(partition);
    const claimant = randomNonce();
    let channel: BrowserOperationTabScopeChannel | undefined;
    try {
      channel = openChannel(channelName(partition));
    } catch {
      channel = undefined;
    }

    if (!channel) {
      const namespace = randomNonce();
      persistNamespace(partition, namespace);
      return { namespace };
    }
    activeChannels.add(channel);

    let namespace = retained ?? randomNonce();
    let finishProbe: (() => void) | undefined;
    let collision = false;
    channel.addEventListener("message", (event) => {
      if (!isClaimMessage(event.data)) return;
      if (event.data.type === "probe" && event.data.claimant === claimant) return;
      if (event.data.type === "probe" && event.data.namespace === namespace) {
        channel?.postMessage({
          version: 1,
          type: "collision",
          namespace,
          claimant: event.data.claimant
        } satisfies ClaimMessage);
      } else if (
        event.data.type === "collision" &&
        event.data.namespace === namespace &&
        event.data.claimant === claimant
      ) {
        collision = true;
        finishProbe?.();
      }
    });

    if (retained) {
      await new Promise<void>((resolve) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          finishProbe = undefined;
          resolve();
        };
        finishProbe = finish;
        setTimeout(finish, claimTimeoutMs);
        channel?.postMessage({ version: 1, type: "probe", namespace, claimant } satisfies ClaimMessage);
      });
    }

    if (collision) namespace = randomNonce();
    persistNamespace(partition, namespace);
    if (closed) channel.close();
    return { namespace, channel };
  }

  return {
    async storageKey(partition, pointerKey) {
      let pending = claims.get(partition);
      if (!pending) {
        pending = resolveClaim(partition);
        claims.set(partition, pending);
      }
      return `${pointerKey}:tab:${(await pending).namespace}`;
    },
    close() {
      closed = true;
      for (const channel of activeChannels) channel.close();
      activeChannels.clear();
      claims.clear();
    }
  };
}

let browserOperationTabScope: BrowserOperationTabScope | undefined;

export function tabScopedBrowserOperationStorageKey(partition: string, pointerKey: string) {
  browserOperationTabScope ??= createBrowserOperationTabScope();
  return browserOperationTabScope.storageKey(partition, pointerKey);
}
