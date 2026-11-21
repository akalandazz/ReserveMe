// Как связаться с клиентом и чем подписать его кружок — общее для
// «Клиентов» и «Аналитики». Без React.

/** Первая буква имени для кружка; «?», если имени нет. */
export function monogram(name) {
  return (name || "").trim().charAt(0).toUpperCase() || "?";
}

/** Куда ведёт круглая кнопка в строке: Telegram, WhatsApp или звонок. null — контактов нет. */
export function contactLink(c) {
  if (c.telegram_username) {
    return {
      href: `https://t.me/${c.telegram_username}`,
      label: "Написать в Telegram",
      icon: "telegram",
    };
  }
  const phone = String(c.phone || "").replace(/[^\d+]/g, "");
  if (!phone) return null;
  if (c.channel === "wa") {
    return {
      href: `https://wa.me/${phone.replace(/\D/g, "")}`,
      label: "Написать в WhatsApp",
      icon: "chat",
    };
  }
  return { href: `tel:${phone}`, label: "Позвонить", icon: "phone" };
}
