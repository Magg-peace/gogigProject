import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type RealtimeState = "connecting" | "live" | "offline";

/**
 * Subscribes to the `uploads` table and invalidates the observability read-models
 * so every console surface reflects worker progress without polling.
 * Returns the channel state so the UI can be honest about whether it is live.
 */
export function useRealtimeUploads(channelName: string, keys: string[][] = [["uploads"], ["analytics"], ["queue-ops"]]) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<RealtimeState>("connecting");

  useEffect(() => {
    const channel = supabase
      .channel(channelName)
      .on("postgres_changes", { event: "*", schema: "public", table: "uploads" }, () => {
        for (const key of keys) void queryClient.invalidateQueries({ queryKey: key });
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setState("live");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED")
          setState("offline");
      });
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelName, queryClient]);

  return state;
}
