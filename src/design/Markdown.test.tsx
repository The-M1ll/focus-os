import { render, screen } from '@testing-library/react';
import { Markdown } from './Markdown';

describe('Markdown', () => {
  it('renders headings, emphasis, code, lists and checklists', () => {
    render(<Markdown source={'# Title\n\nSome **bold**, *italic* and `code`.\n\n- one\n- two\n\n- [x] done\n- [ ] todo\n\n1. first\n2. second'} />);
    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    expect(screen.getByText('italic').tagName).toBe('EM');
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(screen.getAllByRole('listitem')).toHaveLength(6);
    expect(screen.getByRole('checkbox', { name: 'done' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'todo' })).not.toBeChecked();
  });

  it('never emits raw HTML or executable links', () => {
    const { container } = render(<Markdown source={'<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n[click](javascript:alert(1)) [ok](https://example.com)'} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    const ok = screen.getByRole('link', { name: 'ok' });
    expect(ok).toHaveAttribute('rel', 'noopener noreferrer');
    expect(container.textContent).toContain('<script>alert(1)</script>'); // shown as text
    expect(container.textContent).toContain('click');
  });

  it('renders fenced code verbatim', () => {
    const { container } = render(<Markdown source={'```\n# not a heading\n**not bold**\n```'} />);
    expect(container.querySelector('pre code')!.textContent).toBe('# not a heading\n**not bold**');
    expect(container.querySelector('h2')).toBeNull();
  });

  it('handles empty input and quotes', () => {
    const { container } = render(<Markdown source={''} />);
    expect(container.querySelector('.md')!.children).toHaveLength(0);
    render(<Markdown source={'> wise words'} />);
    expect(screen.getByText('wise words').closest('blockquote')).not.toBeNull();
  });
});
