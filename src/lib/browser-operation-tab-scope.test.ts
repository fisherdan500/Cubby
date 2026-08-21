// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createBrowserOperationTabScope, type BrowserOperationTabScopeChannel } from "@/lib/browser-operation-tab-scope";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  clone() {
    const copy = new MemoryStorage();
    for (const [key, value] of this.values) copy.setItem(key, value);
    return copy;
  }
}

class ChannelBus {
  private readonly channels = new Map<string, Set<FakeChannel>>();

  open(name: string): BrowserOperationTabScopeChannel {
    const channel = new FakeChannel(name, this);
    const peers = this.channels.get(name) ?? new Set<FakeChannel>();
    peers.add(channel);
    this.channels.set(name, peers);
    return channel;
  }

  send(sender: FakeChannel, message: unknown) {
    for (const peer of this.channels.get(sender.name) ?? []) {
      if (peer !== sender) queueMicrotask(() => peer.deliver(message));
    }
  }

  close(channel: FakeChannel) {
    this.channels.get(channel.name)?.delete(channel);
  }
}

class FakeChannel implements BrowserOperationTabScopeChannel {
  private listener?: (event: MessageEvent) => void;

  constructor(readonly name: string, private readonly bus: ChannelBus) {}
  addEventListener(_type: "message", listener: (event: MessageEvent) => void) { this.listener = listener; }
  postMessage(message: unknown) { this.bus.send(this, message); }
  close() { this.bus.close(this); }
  deliver(data: unknown) { this.listener?.({ data } as MessageEvent); }
}

function nonceSequence(...nonces: string[]) {
  let index = 0;
  return () => nonces[index++] ?? `nonce-${index}`;
}

describe("browser operation tab scope", () => {
  it("preserves a pointer across remount and same-tab reload", async () => {
    const partition = "household-a";
    const pointerKey = `cubby:baby-create-operation:${partition}`;
    const storage = new MemoryStorage();
    const channels = new ChannelBus();
    const firstDocument = createBrowserOperationTabScope({
      storage,
      openChannel: (name) => channels.open(name),
      randomNonce: nonceSequence("tab-a", "document-a"),
      claimTimeoutMs: 0
    });

    const mountedKey = await firstDocument.storageKey(partition, pointerKey);
    storage.setItem(mountedKey, "bmo_0123456789abcdefghjkmnpqrs");
    expect(await firstDocument.storageKey(partition, pointerKey)).toBe(mountedKey);

    firstDocument.close();
    const reloadedDocument = createBrowserOperationTabScope({
      storage,
      openChannel: (name) => channels.open(name),
      randomNonce: nonceSequence("unused-tab", "document-b"),
      claimTimeoutMs: 0
    });
    const reloadedKey = await reloadedDocument.storageKey(partition, pointerKey);

    expect(reloadedKey).toBe(mountedKey);
    expect(storage.getItem(reloadedKey)).toBe("bmo_0123456789abcdefghjkmnpqrs");
    reloadedDocument.close();
  });

  it("rejects a copied pointer while the source tab still owns the namespace", async () => {
    const partition = "household-a";
    const pointerKey = `cubby:baby-create-operation:${partition}`;
    const sourceStorage = new MemoryStorage();
    const channels = new ChannelBus();
    const sourceTab = createBrowserOperationTabScope({
      storage: sourceStorage,
      openChannel: (name) => channels.open(name),
      randomNonce: nonceSequence("tab-source", "document-source"),
      claimTimeoutMs: 0
    });
    const sourceKey = await sourceTab.storageKey(partition, pointerKey);
    sourceStorage.setItem(sourceKey, "bmo_0123456789abcdefghjkmnpqrs");

    const copiedStorage = sourceStorage.clone();
    const copiedTab = createBrowserOperationTabScope({
      storage: copiedStorage,
      openChannel: (name) => channels.open(name),
      randomNonce: nonceSequence("tab-copy", "document-copy"),
      claimTimeoutMs: 0
    });
    const copiedKey = await copiedTab.storageKey(partition, pointerKey);

    expect(copiedKey).not.toBe(sourceKey);
    expect(copiedStorage.getItem(sourceKey)).toBe("bmo_0123456789abcdefghjkmnpqrs");
    expect(copiedStorage.getItem(copiedKey)).toBeNull();
    sourceTab.close();
    copiedTab.close();
  });
});
