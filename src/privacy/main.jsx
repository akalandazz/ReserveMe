// privacy.html — политика ПДн отдельной страницей, по постоянному адресу:
// его указывают в @BotFather и открывает экран согласия кабинета. Тот же
// текст, что в мини-аппе (src/legal.js), те же стили (src/index.css);
// тема — по системной (prefers-color-scheme в index.css), без переключателя.

import React from "react";
import ReactDOM from "react-dom/client";
import "../index.css";
import { POLICY_DATE } from "../legal.js";
import { OperatorDetails, PolicyText } from "../screens/PrivacyScreen.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <div className="shell">
      <div className="screen-body">
        <h1 className="title">Политика обработки персональных данных</h1>
        <p className="sub">Редакция от {POLICY_DATE}</p>
        <PolicyText />
        <p className="eyebrow">Об исполнителе</p>
        <OperatorDetails />
      </div>
    </div>
  </React.StrictMode>
);
