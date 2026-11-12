import { Lightbulb, PenLine, Sparkles, Compass } from 'lucide-react';
import { setChatDraft } from '../../stores/chatStore';
import { AriaMark } from '../layout/AriaMark';

const suggestions = [
  {
    icon: PenLine,
    title: 'Find the right words',
    description: 'Write something that sounds like you',
    prompt: 'Help me write something. Ask me what I want to say and who it is for.',
  },
  {
    icon: Lightbulb,
    title: 'Make it make sense',
    description: 'Get a fresh perspective on a topic',
    prompt: 'Help me understand a topic. Ask me what I would like to learn about.',
  },
  {
    icon: Sparkles,
    title: 'Explore an idea',
    description: 'Brainstorm a few possibilities',
    prompt: 'Help me brainstorm ideas. Ask me what I am working on.',
  },
  {
    icon: Compass,
    title: 'Make a little plan',
    description: 'Turn a busy day into a clear next step',
    prompt: 'Help me plan my day. Ask me about my priorities and available time.',
  },
];
export function ChatWelcome() {
  return (
    <section className="chat-welcome" aria-label="Welcome to Aria">
      <div className="welcome-mark">
        <AriaMark />
      </div>
      <p className="welcome-eyebrow">A SPACE FOR YOUR CURIOSITY</p>
      <h1>How can I help you today?</h1>
      <p className="welcome-description">
        A question, a rough idea, a fresh start.
        <br />
        Let’s see where the conversation takes us.
      </p>
      <div className="suggested-prompts">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.title}
            onClick={() => {
              setChatDraft(suggestion.prompt, null);
              window.dispatchEvent(new Event('aria:focus-chat'));
            }}
          >
            <suggestion.icon size={19} />
            <strong>{suggestion.title}</strong>
            <span>{suggestion.description}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
