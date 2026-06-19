import { AppShell } from "@/components/app-shell";
import { ApiKeyForm, DeleteWebhookButton, RevokeApiKeyButton, WebhookForm } from "@/components/settings/integration-forms";
import { Card } from "@/components/ui/card";
import { requireUserPage } from "@/server/auth/session";
import { listApiKeys, listWebhooks } from "@/server/services/integrations";

export default async function IntegrationsSettingsPage() {
  const user = await requireUserPage();
  const [apiKeys, webhooks] = await Promise.all([listApiKeys(), listWebhooks()]);

  return (
    <AppShell title="Integrations" userName={user.name}>
      <div className="grid gap-4 xl:grid-cols-2">
        <section className="space-y-4">
          <Card>
            <h2 className="mb-3 text-lg font-black">API keys</h2>
            <ApiKeyForm />
          </Card>
          <Card className="space-y-3">
            {apiKeys.length ? null : <p className="text-sm text-muted-foreground">No API keys yet.</p>}
            {apiKeys.map((key) => (
              <div key={key.id} className="flex items-center justify-between gap-3 rounded-md bg-muted p-3">
                <div>
                  <p className="font-black">{key.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {key.prefix} - {key.scopes.join(", ")} {key.revokedAt ? "- revoked" : ""}
                  </p>
                </div>
                {!key.revokedAt ? <RevokeApiKeyButton id={key.id} /> : null}
              </div>
            ))}
          </Card>
        </section>
        <section className="space-y-4">
          <Card>
            <h2 className="mb-3 text-lg font-black">Webhooks</h2>
            <WebhookForm />
          </Card>
          <Card className="space-y-3">
            {webhooks.length ? null : <p className="text-sm text-muted-foreground">No webhooks configured.</p>}
            {webhooks.map((webhook) => (
              <div key={webhook.id} className="rounded-md bg-muted p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-black">{webhook.name}</p>
                    <p className="text-sm text-muted-foreground">{webhook.url}</p>
                    <p className="text-xs text-muted-foreground">{webhook.events.join(", ")}</p>
                  </div>
                  <DeleteWebhookButton id={webhook.id} />
                </div>
                {webhook.deliveries.length ? (
                  <div className="mt-3 space-y-2">
                    {webhook.deliveries.map((delivery) => (
                      <p key={delivery.id} className="text-xs text-muted-foreground">
                        {delivery.event} - {delivery.status} - {delivery.createdAt.toLocaleString()}
                      </p>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </Card>
        </section>
      </div>
    </AppShell>
  );
}
