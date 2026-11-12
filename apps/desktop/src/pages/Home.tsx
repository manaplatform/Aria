import {
  ArrowRight,
  Bot,
  FolderOpen,
  GitBranch,
  Layers3,
  ListChecks,
  Plus,
  Sparkles,
  Workflow,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { Badge, Button } from '../components/ui';
export default function Home() {
  const data = useWorkspaceStore((state) => state.data);
  const choose = useWorkspaceStore((state) => state.chooseWorkspace);
  const enterSample = useWorkspaceStore((state) => state.enterSample);
  const select = useWorkspaceStore((state) => state.selectWorkspace);
  const navigate = useNavigate();
  return (
    <div className="page-scroll">
      <div className="home-page">
        <div className="home-welcome">
          <span className="eyebrow">
            <span className="status-dot" />
            YOUR AI OPERATING ENVIRONMENT
          </span>
          <h1>
            Good work starts
            <br />
            with a clear workspace.
          </h1>
          <p>
            Bring your projects, plans, and ideas together.
            <br />A calmer place to build what comes next.
          </p>
          <div className="row">
            <Button
              variant="primary"
              onClick={() =>
                void choose().then(() => {
                  if (useWorkspaceStore.getState().data.preferences.activeWorkspaceId)
                    navigate('/workspace');
                })
              }
            >
              <FolderOpen size={16} />
              Open a project
            </Button>
            <Button
              onClick={() => {
                enterSample();
                navigate('/workspace');
              }}
            >
              <Sparkles size={15} />
              Explore sample
            </Button>
          </div>
          <span className="home-footnote">Local first. Your files stay on your device.</span>
        </div>
        <div className="home-section-heading">
          <h2>Recent projects</h2>
          <Button variant="ghost" size="sm" onClick={() => void choose()}>
            <Plus size={13} />
            Add project
          </Button>
        </div>
        {data.workspaces.length ? (
          <div className="project-grid">
            {[...data.workspaces]
              .reverse()
              .slice(0, 6)
              .map((workspace) => (
                <button
                  key={workspace.id}
                  className="project-card"
                  onClick={() => {
                    select(workspace.id);
                    navigate('/workspace');
                  }}
                >
                  <span className="project-icon">
                    <Layers3 size={20} />
                  </span>
                  <strong>{workspace.name}</strong>
                  <code title={workspace.root}>{workspace.root}</code>
                  <span className="row">
                    <GitBranch size={12} />
                    {workspace.branch ?? 'Local folder'}
                    <ArrowRight size={14} className="push-right" />
                  </span>
                </button>
              ))}
          </div>
        ) : (
          <div className="home-empty">
            <FolderOpen size={24} />
            <div>
              <strong>Your projects belong here.</strong>
              <p>Open a local folder to get started. No account needed.</p>
            </div>
            <Button size="sm" onClick={() => void choose()}>
              Choose folder
            </Button>
          </div>
        )}
        <div className="home-section-heading">
          <h2>Built for focused work</h2>
          <Badge>Desktop workspace</Badge>
        </div>
        <div className="feature-grid">
          {[
            {
              icon: ListChecks,
              title: 'Turn ideas into a plan',
              description: 'Create local tasks and checklists that move your project forward.',
            },
            {
              icon: Workflow,
              title: 'Every action, in context',
              description:
                'Inspect commands, file changes, and results when execution is connected.',
            },
            {
              icon: Bot,
              title: 'See the whole team',
              description: 'Follow agent ownership and approvals through a clear hierarchy.',
            },
          ].map((feature) => (
            <div className="feature-tile" key={feature.title}>
              <feature.icon size={19} />
              <h3>{feature.title}</h3>
              <p>{feature.description}</p>
            </div>
          ))}
        </div>
        <div className="sample-callout">
          <div className="sample-callout-icon">
            <Sparkles size={24} />
          </div>
          <div>
            <Badge tone="violet">SAMPLE WORKSPACE</Badge>
            <h3>See a workflow come together.</h3>
            <p>
              Explore a populated activity feed, agent hierarchy, and approval flow. All clearly
              marked as sample data.
            </p>
          </div>
          <Button
            onClick={() => {
              enterSample();
              navigate('/workspace');
            }}
          >
            Take a look
            <ArrowRight size={14} />
          </Button>
        </div>
        {data.conversations.some((item) => item.draft) && (
          <>
            <div className="home-section-heading">
              <h2>Pick up a draft</h2>
              <Button variant="ghost" size="sm" onClick={() => navigate('/history')}>
                View history
                <ArrowRight size={13} />
              </Button>
            </div>
            {data.conversations
              .filter((item) => item.draft)
              .slice(-3)
              .reverse()
              .map((conversation) => (
                <button
                  key={conversation.id}
                  className="history-row"
                  onClick={() => {
                    select(conversation.workspaceId);
                    useWorkspaceStore.getState().selectConversation(conversation.id);
                    navigate('/workspace');
                  }}
                >
                  <ListChecks size={16} />
                  <span>
                    <strong>{conversation.title}</strong>
                    <small>
                      Local draft · {new Date(conversation.updatedAt).toLocaleDateString()}
                    </small>
                  </span>
                  <ArrowRight size={15} />
                </button>
              ))}
          </>
        )}
      </div>
    </div>
  );
}
