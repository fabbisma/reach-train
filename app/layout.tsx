import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EcoRail Planner",
  description: "Optimisation voiture + gare stratégique + train"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
