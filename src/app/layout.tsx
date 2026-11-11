import type { Metadata } from "next";
import { Be_Vietnam_Pro, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const vn = Be_Vietnam_Pro({ variable: "--font-vn", subsets: ["latin", "vietnamese"], weight: ["400", "500", "600", "700"] });
const jb = JetBrains_Mono({ variable: "--font-jb", subsets: ["latin"], weight: ["400", "600"] });

export const metadata: Metadata = {
  title: "QA Flow Hub",
  description: "Quản lý quy trình test: Jira, TestLink và AI",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="vi" className={`${vn.variable} ${jb.variable}`}>
      <body>{children}</body>
    </html>
  );
}
