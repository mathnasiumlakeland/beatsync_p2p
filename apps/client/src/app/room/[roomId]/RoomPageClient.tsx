"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
/** Old bookmarks always enter the site's single room. */
export function RoomPageClient(_props: { roomId: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace("/");
  }, [router]);
  return null;
}
