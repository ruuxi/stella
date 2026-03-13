export type AppendedEventResponse = {
  _id?: string;
  id?: string;
};

export const toEventId = (
  event: AppendedEventResponse | null | undefined,
): string | null => {
  if (!event) return null;
  if (typeof event._id === "string" && event._id.length > 0) return event._id;
  if (typeof event.id === "string" && event.id.length > 0) return event.id;
  return null;
};
