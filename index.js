const channelLabels = [
  '测试作者',
  '美食作家王刚',
  '雪鱼探店',
  '华农兄弟',
];

const channelFolders = [
  'test-author',
  'wang-gang',
  'xue-yu',
  'hua-nong-brothers',
];

const statusLabels = [
  '待翻译',
  '待审阅',
  '待上传',
  '待发布',
];

// Returns whether the issue/pull is open or closed
async function isOpen(context, number) {
  const response = await context.github.issues.get(context.issue({number: number}));
  const result = (response.data.state === 'open');
  return result;
}

// Returns all labels of an issue/pull
async function getAllLabels(context, number) {
  const response = await context.github.issues.listLabelsOnIssue(context.issue({number: number}));
  const result = [];
  response.data.forEach(item => result.push(item.name));
  return result;
}

async function getChannelLabel(context, number) {
  const labels = await getAllLabels(context, number);
  for (let label of labels) {
    if (channelLabels.includes(label))
      return label;
  }
  return null;
}

async function setStatusLabel(context, issueNumber, label) {
  await removeAllStatusLabels(context, issueNumber);
  context.github.issues.addLabels(context.issue({
    number: issueNumber,
    issue_number: issueNumber,
    labels: [label]
  }));
}

// Returns true if the pull request uploads a single file into a subdir
// of `/subtitles/` (e.g., `/subtitles/wang-gang/`)
async function isSubtitlePull(context, pullNumber) {
  const response = await context.github.pulls.listFiles(context.issue({number: pullNumber}));
  const files = response.data;
  if (files.length !== 1)
    return false;

  const filename = files[0].filename;
  if (!filename.startsWith('subtitles/'))
    return false;
  return filename.split('/').length === 3;
}

async function getSubtitleIssueNumberFromComment(context, commentBody) {
  const regex = /#\d+/g;
  const matches = commentBody.match(regex);
  if (!matches)
    return null;
  for (let match of matches) {
    const number = parseInt(match.substring(1));
    if (await getChannelLabel(context, number))
      return number;
  }
  return null;
}

// Returns the first mentioned issue number in a pull request, such that
// the issue has a channel label
async function getSubtitleIssueNumber(context, pullNumber) {
  let result = null;
  const pull_details = await context.github.pulls.get(context.issue({number: pullNumber}));
  result = await getSubtitleIssueNumberFromComment(context, pull_details.data.body);
  if (result)
    return result;
  const comments = await context.github.issues.listComments(context.issue({number: pullNumber}));
  for (let comment of comments.data) {
    result = getSubtitleIssueNumberFromComment(context, comment.body);
    if (result)
      return result;
  }
  return null;
}

async function removeAllStatusLabels(context, issueNumber) {
  let labels = await getAllLabels(context, issueNumber);
  labels.filter(label => statusLabels.includes(label)).forEach(label => {
    context.github.issues.removeLabel(context.issue({
      number: issueNumber,
      issue_number: issueNumber,
      name: label
    }));
  });
}

function getSubtitleRequestBody(message) {
  // TODO: make the pattern matching more versatile
  const header = 'bot, please upload';
  if (!message.startsWith(header))
    return null;
  return message.substring(header.length);
}

module.exports = app => {
  // Channel and "待翻译" to new issues
  app.on('issues.opened', async context => {
    const title = context.payload.issue.title;
    let labels = [];
    for (let i = 0; i < channelLabels.length; ++i) {
      const currentChannel = channelLabels[i];
      if (title.startsWith(`[${currentChannel}]`) || title.startsWith(`【${currentChannel}】`)) {
        labels.push(currentChannel);
      }
    }
    if (!labels.length)
      return;
    labels.push('待翻译');
    context.github.issues.addLabels(context.issue({labels: labels}));
  });

  // When a pull request is opened, and it (1) is a subtitle upload, and (2) mentions an issue when opened,
  // (3) the issue is open and contains a channel label, then (a) apply channel label to pull request,
  // and (b) apply "待审阅" label to issue
  app.on('pull_request.opened', async context => {
    const pull = context.payload.pull_request;
    if (!await isSubtitlePull(context, pull.number))
      return;
    const issueNumber = await getSubtitleIssueNumberFromComment(context, pull.body);
    if (!issueNumber)
      return;
    if (!await isOpen(context, issueNumber))
      return;
    const channelLabel = await getChannelLabel(context, issueNumber);
    if (!channelLabel)
      return;
    await setStatusLabel(context, issueNumber, '待审阅');
    context.github.issues.addLabels(context.issue({number: pull.number, labels: [channelLabel]}));
  });

  // When a pull request comment is added, and it (i) belongs to a subtitle upload, and (2) firstly mentions
  // an issue in the pull request, and (3) the issue is open and contains a channel label, then
  // (a) apply channel label to pull request, and (b) apply "待审阅" label to issue
  app.on('issue_comment.created', async context => {
    if (context.payload.issue.state !== 'open')
      return;
    if (!context.payload.issue.pull_request)
      return;
    const pull = context.payload.issue;
    if (!await isSubtitlePull(context, pull.number))
      return;
    const issueNumber = await getSubtitleIssueNumberFromComment(context, context.payload.comment.body);
    if (!issueNumber)
      return;
    if (!await isOpen(context, issueNumber))
      return;
    const channelLabel = await getChannelLabel(context, issueNumber);
    if (!channelLabel)
      return;
    await setStatusLabel(context, issueNumber, '待审阅');
    await context.github.issues.addLabels(context.issue({number: pull.number, labels: [channelLabel]}));
  });

  // When a pull request is merged, and it (1) is a subtitle upload, (2) mentions an open issue with a
  // channel label, then (a) apply "待上传" label to issue
  app.on('pull_request.closed', async context => {
    const pull = context.payload.pull_request;
    if (!pull.merged)
      return;
    if (!await isSubtitlePull(context, pull.number))
      return;
    const issueNumber = await getSubtitleIssueNumber(context, pull.number);
    if (!issueNumber)
      return;
    if (!await isOpen(context, issueNumber))
      return;
    if (!await getChannelLabel(context, issueNumber))
      return;
    await setStatusLabel(context, issueNumber, '待上传');
  });

  // When the assignee replies to a subtitle issue, and the comment body starts with 'bot, please upload'
  // followed by the subtitles to be uploaded,
  // 1. Creates a pull request that adds a single file with the subtitles as file content
  // 2. Replies to the issue and folds the subtitles in the previous comment
  app.on('issue_comment.created', async context => {
    if (context.payload.issue.pull_request)
      return;
    if (!context.payload.issue.assignee)
      return;
    const author = context.payload.sender;
    if (author.id !== context.payload.issue.assignee.id)
      return;
    if (!context.payload.issue.labels)
      return;
    let channelLabel;
    let channelFolder;
    for (let i = 0; i < context.payload.issue.labels.length; ++i) {
      const label = context.payload.issue.labels[i];
      if (!channelLabels.includes(label.name))
        continue;
      channelLabel = label;
      channelFolder = channelFolders[i];
      break;
    }
    if (!channelLabel)
      return;
    const comment = context.payload.comment.body;
    const subtitles = getSubtitleRequestBody(comment);
    if (!subtitles)
      return;

    const owner = context.payload.repository.owner.login;
    const repo = context.payload.repository.name;
    const issueNumber = context.payload.issue.number;
    const newBranch = `issue-${issueNumber}-${Math.floor(Math.random() * 10)}`;

    // Get hash of master branch
    const masterBranch = await context.github.repos.getBranch({
      owner: owner,
      repo: repo,
      branch: 'master'
    });
    const sha = masterBranch.data.commit.sha;

    // Create a new tree with a new file, on top of master 
    const newFileName = `subtitles-issue-${issueNumber}`; // TODO: improve this
    const newFile = {
      path: `subtitles/${channelFolder}/${newFileName}`,
      mode: '100644',
      type: 'blob',
      content: subtitles
    };
    const newTree = await context.github.git.createTree({
      owner: owner,
      repo: repo,
      base_tree: sha,
      tree: [newFile],
    });

    // Commit the new tree
    // TODO: Set author correctly
    const newCommit = await context.github.git.createCommit({
      owner: owner,
      repo: repo,
      message: `Upload subtitles for issue #${issueNumber} on behalf of @${author.login}`,
      tree: newTree.data.sha,
      parents: [sha],
    });

    // Create a new branch referring the commit
    const newRef = await context.github.git.createRef({
      owner: owner,
      repo: repo,
      ref: `refs/heads/${newBranch}`,
      sha: newCommit.data.sha,
    });

    // Create a new pull request
    const newPull = await context.github.pulls.create({
      owner: owner,
      repo: repo,
      title: context.payload.issue.title,
      head: newBranch,
      base: 'master',
      body: `#${issueNumber}\n\nUploaded on behalf of @${author.login}`,
      maintainer_can_modify: true,
    });

    // Edit the original issue comment to collapse the subtitles
    const codequote = '```';
    const editedComment = await context.github.issues.updateComment({
      owner: owner,
      repo: repo,
      comment_id: context.payload.comment.id,
      body: `bot, please upload\n\n<details><summary>Subtitles uploaded as pull request</summary>${codequote}\n${subtitles}\n${codequote}</details>`
    });

    // Post a comment to the issue to notify pull request creation
    const newComment = await context.github.issues.createComment(context.issue({
      body: `@${author.login}, I've uploaded your subtitles as #${newPull.data.number}.`
    }));
  });

}