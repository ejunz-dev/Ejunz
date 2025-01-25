import keyword from 'emojis-keywords';
import list from 'emojis-list';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import qface from 'qface';
import { api, gql } from 'vj/utils';

function emoji(range) {
  return keyword.map((i, index) => ({
    label: `${list[index]} ${i}`,
    kind: monaco.languages.CompletionItemKind.Keyword,
    documentation: i,
    insertText: list[index],
    range,
  }));
}

function qqEmoji(range) {
  return qface.data.flatMap((i) => {
    const url = qface.getUrl(i.QSid, 'https://qq-face.vercel.app');
    return [i.QDes.substring(1), ...(i.Input || [])].map((input) => ({
      label: `/${input}`,
      kind: monaco.languages.CompletionItemKind.Keyword,
      documentation: { value: `![${i.QDes}](${url})`, isTrusted: true },
      insertText: `![${i.Input ? i.Input[0] : i.QDes.substring(1)}](${url} =32x32) `,
      range,
    }));
  });
}

monaco.editor.registerCommand('.openUserPage', (accesser, uid) => {
  window.open(`/user/${uid}`);
});

monaco.languages.registerCodeLensProvider('markdown', {
  async provideCodeLenses(model) {
    const users = model.findMatches('\\[\\]\\(/user/(\\d+)\\)', true, true, true, null, true);
    if (!users.length) {
      return {
        lenses: [],
        dispose: () => { },
      };
    }
    const { data } = await api(gql`
      users(ids: ${users.map((i) => +i.matches[1])}) {
        _id
        uname
      }
    `);
    return {
      lenses: users.map((i, index) => ({
        range: i.range,
        id: `${index}.${i.matches[1]}`,
        command: {
          id: '.openUserPage',
          arguments: [i.matches[1]],
          title: `@${data.users.find((doc) => doc._id.toString() === i.matches[1])?.uname || i.matches[1]}`,
        },
      })),
      dispose: () => { },
    };
  },
  resolveCodeLens(model, codeLens) {
    return codeLens;
  },
});

monaco.languages.registerCompletionItemProvider('markdown', {
  async provideCompletionItems(model, position) {
    const word = model.getWordAtPosition(position);
    if (word.word.length < 2) return { suggestions: [] };
    const prefix = model.getValueInRange({
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: word.startColumn - 1,
      endColumn: word.startColumn,
    });
    if (![':', '/', '@'].includes(prefix)) return { suggestions: [] };
    const range = {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: word.startColumn - 1,
      endColumn: word.endColumn,
    };
    if (prefix === '@') {
      const users = await api(gql`
        users(search: ${word.word}) {
          _id
          uname
          avatarUrl
          priv
        }
      `, ['data', 'users']);
      return {
        suggestions: users.map((i) => ({
          label: { label: `@${i.uname}`, description: `UID=${i._id}` },
          kind: monaco.languages.CompletionItemKind.Property,
          documentation: { value: `[](#loader) ![avatar](${new URL(i.avatarUrl, window.location.href)})`, isTrusted: true },
          insertText: `@[](/user/${i._id}) `,
          range,
          sortText: i.priv === 0 ? '0' : '1',
          tags: i.priv === 0 ? [1] : [],
        })),
      };
    }
    return {
      suggestions: prefix === ':' ? emoji(range) : qqEmoji(range),
    };
  },
});

monaco.languages.registerCompletionItemProvider('markdown', {
  async provideCompletionItems(model, position) {
    const word = model.getWordAtPosition(position);
    if (!word || word.word.length < 2) return { suggestions: [] };

    const prefix = model.getValueInRange({
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: word.startColumn - 1,
      endColumn: word.startColumn,
    });

    if (prefix !== '@') return { suggestions: [] };

    const range = {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: word.startColumn - 1,
      endColumn: word.endColumn,
    };

    const text = model.getValueInRange(range);
    const match = text.match(/@\[\]\(\/docs\/(\d+)\)/);

    if (!match) return { suggestions: [] };

    const docId = parseInt(match[1], 10);
    if (isNaN(docId)) return { suggestions: [] }; // 避免无效 ID

    console.log("Fetching title for docId:", docId);

    // 通过 GraphQL 查询文档标题
    const { data } = await api(gql`
      query GetDocsTitle {
        docs(ids: [${docId}]) {
          docId
          title
        }
      }
    `, ['data', 'docs']);

    console.log("GraphQL response:", data);

    const doc = data?.docs?.[0];
    const title = doc?.title || `📄 文档 ${docId}`;

    return {
      suggestions: [
        {
          label: `@${title}`,
          kind: monaco.languages.CompletionItemKind.Text,
          insertText: `@[](/docs/${docId}) `,
          range,
        },
      ],
    };
  },
});



monaco.languages.registerCodeLensProvider('markdown', {
  async provideCodeLenses(model) {
    const docs = model.findMatches('@\\[\\]\\(/docs/(\\d+)\\)', true, true, true, null, true);
    if (!docs.length) {
      return { lenses: [], dispose: () => {} };
    }

    // 确保所有 docId 传入 GraphQL 之前转换为数字
    const docIds = docs.map((d) => parseInt(d.matches[1], 10)).filter((id) => !isNaN(id));

    console.log("Fetching docs for docIds:", docIds);

    // 通过 GraphQL 查询 docs 标题
    const { data } = await api(gql`
      query GetDocsTitles {
        docs(ids: [${docIds.join(',')}]) {
          docId
          title
        }
      }
    `, ['data', 'docs']);

    console.log("GraphQL response:", data);

    // 生成 CodeLens 以展示文档标题
    return {
      lenses: docs.map((d, index) => {
        const docId = parseInt(d.matches[1], 10);
        const doc = data?.docs?.find((doc) => doc.docId === docId);
        const title = doc?.title || `📄 文档 ${docId}`;

        return {
          range: d.range,
          id: `${index}.${docId}`,
          command: {
            id: '.openDocPage',
            arguments: [docId],
            title: title,
          },
        };
      }),
      dispose: () => {},
    };
  },
});


