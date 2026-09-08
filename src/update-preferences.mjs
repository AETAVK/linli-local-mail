const KEY = "updater.automaticCheck";

export function getUpdatePreferences(database) {
  return { automaticCheck: database.getSetting(KEY) !== "0" };
}

export function setUpdatePreferences(database, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
      || typeof input.automaticCheck !== "boolean") {
    const error = new Error("automaticCheck 必须是布尔值");
    error.status = 400;
    throw error;
  }
  database.setSetting(KEY, input.automaticCheck ? "1" : "0");
  return getUpdatePreferences(database);
}
