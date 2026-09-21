import { renderAppIcon } from '@/lib/app-icon'

/** The splash-screen and store-listing size. */
export function GET() {
  return renderAppIcon(512, true)
}
