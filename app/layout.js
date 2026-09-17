import './globals.css';

export const metadata = {
  title: 'Kapitalstrøm',
  description: 'Norsk finans- og økonomiredaksjon',
};

export default function RootLayout({ children }) {
  return (
    <html lang="no">
      <body>{children}</body>
    </html>
  );
}
