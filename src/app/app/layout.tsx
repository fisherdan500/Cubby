import { getCurrentAppearanceTheme } from "@/server/services/appearance";

export default async function AuthenticatedAppLayout({ children }: { children: React.ReactNode }) {
  const accentTheme = await getCurrentAppearanceTheme();
  return <div data-accent={accentTheme}>{children}</div>;
}
