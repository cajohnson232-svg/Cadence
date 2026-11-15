import type { Metadata } from "next";
import "./globals.css";

// A private application: search engines are asked not to list any of it.
export const metadata: Metadata = { title: "Cadence", description: "Scheduling for emergency medicine residencies", robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
