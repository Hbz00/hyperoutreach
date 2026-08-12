import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Hyperoutreach",
  description: "Evidence-backed prospecting and customer discovery",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
