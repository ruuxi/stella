export const createMonotonicSeqGenerator = (initialValue = 0) => {
  let lastValue = initialValue;

  return () => {
    lastValue = Math.max(lastValue + 1, Date.now());
    return lastValue;
  };
};
