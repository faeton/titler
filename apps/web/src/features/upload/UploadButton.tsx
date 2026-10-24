import { useRef } from "react";
import { go } from "../../lib/hooks";
import { startUpload } from "./uploads";

export const UploadButton = ({ label = "Загрузить видео" }: { label?: string }) => {
  const input = useRef<HTMLInputElement>(null);
  const onFiles = async (files: FileList | null) => {
    const list = [...(files ?? [])];
    if (input.current) input.current.value = "";
    const ids = await Promise.all(list.map((f) => startUpload(f)));
    const first = ids.find(Boolean);
    if (list.length === 1 && first) go("p", first, "audio");
  };
  return (
    <label className="btn primary big">
      <input
        ref={input}
        type="file"
        accept="video/*,.mov,.mp4,.m4v"
        multiple
        className="sr"
        onChange={(e) => void onFiles(e.target.files)}
      />
      ＋ {label}
    </label>
  );
};
