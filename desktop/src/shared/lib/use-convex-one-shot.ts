import { useConvex } from "convex/react";
import {
  getFunctionName,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
} from "convex/server";
import { useEffect, useRef, useState } from "react";

/**
 * One-shot Convex query that mirrors `useQuery`'s call shape but does
 * not keep an open WebSocket subscription. Use for read-mostly data
 * that won't meaningfully change while the component is mounted —
 * billing status, package metadata, identity profile, catalog rows,
 * etc. Subscriptions are still the right call when another user or
 * another window can mutate the data live (chat messages, presence,
 * job progress).
 *
 * Returns `undefined` while loading (or until the previous result
 * matches the current args / `refreshKey`), then the value, then
 * `undefined` on error. Pass `"skip"` to defer the fetch. Bump
 * `refreshKey` to force a re-fetch with the same args.
 *
 * Implementation note: `api.foo.bar` is a recursive Proxy from
 * `convex/server`'s `anyApi`, which returns a NEW `FunctionReference`
 * object on every property access. So the `query` reference is unstable
 * across renders and cannot be used directly as a `useEffect` dep —
 * doing so causes an infinite render loop. We key the effect off
 * `getFunctionName(query)` (a stable string like
 * `"data/pets:listTagFacets"`) and read the live query/args via refs.
 */
export function useConvexOneShot<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query> | "skip",
  refreshKey?: string | number,
): FunctionReturnType<Query> | undefined {
  const convex = useConvex();
  // Args are usually constructed inline (`{ packageId }`), so we key off
  // a serialized form to match `useQuery`'s deep-equality semantics
  // instead of refiring on every fresh object reference.
  const argsKey = args === "skip" ? "__skip__" : JSON.stringify(args);
  const queryName = getFunctionName(query);
  const fetchToken = `${queryName}::${argsKey}::${refreshKey ?? ""}`;

  const queryRef = useRef(query);
  queryRef.current = query;
  const argsRef = useRef(args);
  argsRef.current = args;

  // Pair the data with the token it was fetched for so we can return
  // `undefined` (loading) when the args change but the in-flight fetch
  // hasn't landed yet — avoids briefly rendering data for the previous
  // args under a new key.
  const [entry, setEntry] = useState<{
    token: string;
    data: FunctionReturnType<Query> | undefined;
  }>({ token: "__init__", data: undefined });

  useEffect(() => {
    const currentArgs = argsRef.current;
    if (currentArgs === "skip") {
      setEntry((prev) =>
        prev.token === fetchToken ? prev : { token: fetchToken, data: undefined },
      );
      return;
    }
    let cancelled = false;
    void convex
      .query(queryRef.current, currentArgs as FunctionArgs<Query>)
      .then((result) => {
        if (cancelled) return;
        setEntry({
          token: fetchToken,
          data: result as FunctionReturnType<Query>,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setEntry({ token: fetchToken, data: undefined });
      });
    return () => {
      cancelled = true;
    };
  }, [convex, fetchToken]);

  return entry.token === fetchToken ? entry.data : undefined;
}
