export const Legend = () => (
  <div className="legend" aria-label="Обозначения">
    <div className="pm" style={{ userSelect: "text" }}>
      <span className="w">обычное</span> · <span className="w w-cur">звучит сейчас</span> ·{" "}
      <span className="w w-sel">выбрано</span> · <span className="w w-review">проверить</span> ·{" "}
      <span className="w w-unconf">тайминг не подтверждён</span> · <span className="w w-new">ещё не сохранено</span> ·{" "}
      <span className="w w-manual">тайминг вручную</span> · <span className="w w-hidden">убрано из субтитров</span>
    </div>
    <p className="hint">
      Касание — выбрать слово и перейти к нему. Второе касание или «Править» — клавиатура. Удержание — выделить
      несколько слов. На компьютере: ←/→ по словам, Shift — диапазон, Enter — править, C — контекст, пробел — плей.
    </p>
  </div>
);
