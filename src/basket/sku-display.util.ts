export function replaceSkuDisplayValue(
  rawSku: string,
  matchedSku: string | null | undefined,
  replaceValue: string | null | undefined,
): string {
  const sourceSku = String(rawSku || '');
  const targetSku = String(matchedSku || '');
  const replacement = typeof replaceValue === 'string' ? replaceValue.trim() : '';

  if (!sourceSku || !targetSku || !replacement) {
    return sourceSku;
  }

  const matchedIndex = sourceSku.indexOf(targetSku);
  if (matchedIndex === -1) {
    return sourceSku;
  }

  return sourceSku.slice(0, matchedIndex) + replacement + sourceSku.slice(matchedIndex + targetSku.length);
}
