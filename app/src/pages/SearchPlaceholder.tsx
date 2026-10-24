import { Button, EmptyState } from '../ui';
import { IconSearch } from '../ui/icons';
import { PageHeader } from '../shell/PageHeader';

/** #search — placeholder until the search page (UI-3) lands; keeps the nav
 * entry and the URL stable. */
export function SearchPlaceholderPage({ onGoHome }: { onGoHome: () => void }) {
  return (
    <>
      <PageHeader title="搜索" subtitle="全部聊天记录" />
      <EmptyState
        layout="page"
        icon={<IconSearch size={26} />}
        title="全局搜索正在路上"
        description="之后可以按联系人、日期、消息类型搜索全部聊天记录，并跳到原消息。索引在本机建立，不联网。现在可以先在首页按名字找朋友。"
        actions={<Button variant="secondary" onClick={onGoHome}>回到首页</Button>}
      />
    </>
  );
}
