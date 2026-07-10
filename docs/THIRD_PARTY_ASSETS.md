# Third-Party Assets

Cubby keeps runtime visual dependencies local so the app remains self-hostable
without a font or image CDN.

## Fonts

- Manrope is installed through `@fontsource/manrope` and used for interface and
  body text. Manrope is distributed under the SIL Open Font License 1.1.
- Fraunces is installed through `@fontsource/fraunces` and used selectively for
  editorial headings. Fraunces is distributed under the SIL Open Font License
  1.1.

Font files are bundled from `node_modules` by Next.js. Package license files are
the authoritative license text.

## Icons

Cubby uses `lucide-react` for familiar utility controls. Lucide is distributed
under the ISC license.

## Original Cubby Artwork

The activity thumbnails in `public/activity-art` and the subtle paper texture in
`public/textures` were generated specifically for Cubby. They are not copied
from Sprout Track or another baby-tracking product. Activity art is rendered by
`src/components/activity-artwork.tsx`, which retains a Lucide fallback if an
image cannot load.
