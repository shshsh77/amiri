const fold = text => text.toLowerCase().replaceAll("ё", "е").trim();
const catalog = {
  categories: ["Под-системы и расходники", "Жидкости", "Никотиновые паучи", "Одноразовые устройства"],
  lineKey({ id, category, brand, line }) {
    return line ? JSON.stringify([category, fold(brand || ""), fold(line)]) : id;
  },
};

if (typeof module === "undefined") window.AMIRI_CATALOG = catalog;
else module.exports = catalog;
