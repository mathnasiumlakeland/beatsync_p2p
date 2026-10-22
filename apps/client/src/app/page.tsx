"use client";
import { NewSyncer } from "@/components/NewSyncer";
import { SINGLE_ROOM_ID } from "@/p2p/constants";

export default function Home() {
  return <NewSyncer roomId={SINGLE_ROOM_ID} />;
}
