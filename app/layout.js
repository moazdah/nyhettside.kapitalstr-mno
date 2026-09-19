import './globals.css';
import { SITE_URL } from '../lib/site';

export const metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Kapitalstrøm',
    template: '%s | Kapitalstrøm',
  },
  description: 'Norsk finans- og økonomiredaksjon',
  openGraph: {
    siteName: 'Kapitalstrøm',
    type: 'website',
    locale: 'nb_NO',
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="no">
      <body>{children}</body>
    </html>
  );
}
