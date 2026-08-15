import * as Dialog from "@radix-ui/react-dialog";
import { motion } from "motion/react";
import type { ReactNode } from "react";

export function DialogFrame({
  title,
  eyebrow,
  onClose,
  children,
  widthClass = "max-w-[720px]",
}: {
  title: string;
  eyebrow: string;
  onClose: () => void;
  children: ReactNode;
  widthClass?: string;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay asChild>
          <motion.div className="dialog-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }} />
        </Dialog.Overlay>
        <Dialog.Content asChild>
          <motion.section
            className={`series-dialog fixed left-1/2 top-1/2 z-[130] w-[calc(100vw-32px)] ${widthClass} -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[22px] border border-black/10 bg-white/95 shadow-2xl outline-none backdrop-blur-2xl`}
            initial={{ opacity: 0, scale: 0.985, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            <header className="dialog-head">
              <div>
                <span className="eyebrow">{eyebrow}</span>
                <Dialog.Title asChild><h2>{title}</h2></Dialog.Title>
              </div>
              <Dialog.Close asChild><button className="icon-button" aria-label="Close">×</button></Dialog.Close>
            </header>
            {children}
          </motion.section>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
