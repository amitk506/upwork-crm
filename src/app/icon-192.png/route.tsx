import { renderAppIcon } from '@/lib/app-icon'

/** Referenced by the web manifest. Maskable, so Android can crop it to any shape. */
export function GET() {
  return renderAppIcon(192, true)
}
