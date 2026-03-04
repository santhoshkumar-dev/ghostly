import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { motion } from "framer-motion";

interface SolutionCardProps {
  content: string;
  isStreaming?: boolean;
}

export const SolutionCard: React.FC<SolutionCardProps> = ({
  content,
  isStreaming,
}) => {
  const [copiedBlock, setCopiedBlock] = React.useState<string | null>(null);

  const copyToClipboard = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedBlock(id);
      setTimeout(() => setCopiedBlock(null), 2000);
    } catch {
      /* clipboard access may be denied */
    }
  };

  const components = useMemo(
    () => ({
      code({
        className,
        children,
        ...props
      }: React.HTMLAttributes<HTMLElement> & { inline?: boolean }) {
        const match = /language-(\w+)/.exec(className || "");
        const codeString = String(children).replace(/\n$/, "");
        const blockId = `code-${codeString.slice(0, 20)}`;

        if (match) {
          return (
            <div className="relative group my-3 rounded-lg overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2 bg-dark-950 border-b border-dark-700">
                <span className="text-xs font-mono text-dark-400">
                  {match[1]}
                </span>
                <button
                  onClick={() => copyToClipboard(codeString, blockId)}
                  className="text-xs text-dark-400 hover:text-ghostly-400 transition-colors no-drag"
                >
                  {copiedBlock === blockId ? "✓ Copied" : "Copy"}
                </button>
              </div>
              <SyntaxHighlighter
                style={oneDark}
                language={match[1]}
                PreTag="div"
                customStyle={{
                  margin: 0,
                  borderRadius: 0,
                  background: "rgba(20, 20, 23, 0)",
                  backdropFilter: "blur(24px)",
                  fontSize: "13px",
                  lineHeight: "1.6",
                }}
              >
                {codeString}
              </SyntaxHighlighter>
            </div>
          );
        }

        return (
          <code
            className="px-1.5 py-0.5 rounded bg-dark-800 text-ghostly-300 font-mono text-xs"
            {...props}
          >
            {children}
          </code>
        );
      },
      h2: ({
        children,
        ...props
      }: React.HTMLAttributes<HTMLHeadingElement>) => (
        <h2
          className="text-lg font-semibold text-dark-100 mt-5 mb-2 flex items-center gap-2"
          {...props}
        >
          <span className="w-1 h-5 rounded-full ghostly-gradient inline-block" />
          {children}
        </h2>
      ),
      h3: ({
        children,
        ...props
      }: React.HTMLAttributes<HTMLHeadingElement>) => (
        <h3
          className="text-base font-medium text-dark-200 mt-4 mb-1.5"
          {...props}
        >
          {children}
        </h3>
      ),
      p: ({
        children,
        ...props
      }: React.HTMLAttributes<HTMLParagraphElement>) => (
        <p className="text-sm text-dark-300 leading-relaxed mb-2" {...props}>
          {children}
        </p>
      ),
      ul: ({ children, ...props }: React.HTMLAttributes<HTMLUListElement>) => (
        <ul
          className="list-disc list-inside text-sm text-dark-300 space-y-1 mb-2"
          {...props}
        >
          {children}
        </ul>
      ),
      li: ({ children, ...props }: React.HTMLAttributes<HTMLLIElement>) => (
        <li className="text-sm text-dark-300" {...props}>
          {children}
        </li>
      ),
      strong: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => (
        <strong className="font-semibold text-dark-100" {...props}>
          {children}
        </strong>
      ),
    }),
    [copiedBlock],
  );

  if (!content) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="card relative"
    >
      {isStreaming && (
        <div className="absolute top-3 right-3 flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-ghostly-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-ghostly-500" />
          </span>
          <span className="text-xs text-ghostly-400 font-medium">
            Streaming
          </span>
        </div>
      )}

      <div className="prose prose-invert prose-sm max-w-none">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={components as any}
        >
          {content}
        </ReactMarkdown>
      </div>

      {!isStreaming && content && (
        <div className="mt-4 pt-3 border-t border-dark-800 flex justify-end">
          <button
            onClick={() => copyToClipboard(content, "full")}
            className="btn-ghost text-xs"
          >
            {copiedBlock === "full" ? "✓ Copied All" : "📋 Copy All"}
          </button>
        </div>
      )}
    </motion.div>
  );
};
