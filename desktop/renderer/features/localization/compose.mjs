export function composeLocale(parts) {
  const dictionary = {};
  for (const entries of parts) for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' ||
        !/^[a-zA-Z][\w-]*(?:\.[\w-]+)+$/u.test(entry[0]) || typeof entry[1] !== 'string') {
      throw new TypeError('invalid localization entry');
    }
    const [key, value] = entry;
    if (Object.prototype.hasOwnProperty.call(dictionary, key)) throw new Error('duplicate localization key: ' + key);
    dictionary[key] = value;
  }
  return dictionary;
}

export function assertMatchingKeys(dictionaries) {
  const expected = Object.keys(dictionaries.zh).sort();
  for (const locale of Object.keys(dictionaries)) {
    const keys = Object.keys(dictionaries[locale]).sort();
    if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) {
      throw new Error('localization key mismatch: ' + locale);
    }
  }
  return true;
}
