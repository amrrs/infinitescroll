import { useState } from "react";

type Props = {
  onSubmit: (text: string) => void;
  placeholder?: string;
};

export const ChatInput = ({ onSubmit, placeholder }: Props) => {
  const [value, setValue] = useState("");
  return (
    <form
      className="chat-form"
      onSubmit={(event) => {
        event.preventDefault();
        const text = value.trim();
        if (!text) return;
        onSubmit(text);
        setValue("");
      }}
    >
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder ?? "Describe a theme..."}
        aria-label="Prompt"
      />
      <button type="submit">Generate</button>
    </form>
  );
};
