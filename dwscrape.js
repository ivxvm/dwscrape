import assert from 'assert';
import fs from 'fs';
import axios from 'axios';
import { JSDOM } from 'jsdom';
import * as R from 'ramda';
import pThrottle from 'p-throttle';

const BASE_URL = 'https://www.doomworld.com/forum/4-wads-mods';
const DB_FILE_PATH = './db.json';
const ATTACHMENTS_DIR_PATH = './attachments';

const SELECTORS = {
    pagination: '.ipsPagination_pageJump',
    forumThreadLink: '.ipsDataItem_title a[data-ipshover-target]',
    threadPost: '.cPost',
    threadPost_author: '.ipsComment_author .cAuthorPane_author a',
    threadPost_text: '.cPost_contentWrap .ipsType_richText',
    threadPost_text_iframe: '.cPost_contentWrap .ipsType_richText iframe',
    threadPost_attachment: 'a.ipsAttachLink',
};

if (!fs.existsSync(DB_FILE_PATH)) {
    console.log('Database file not found, creating empty database');
    fs.writeFileSync(DB_FILE_PATH, '{}');
}

if (!fs.existsSync(ATTACHMENTS_DIR_PATH)) {
    console.log('Attachments directory not found, creating empty directory');
    fs.mkdirSync(ATTACHMENTS_DIR_PATH);
}

const throttle = pThrottle({
    limit: 1,
    interval: 1000,
});

const downloadFile = (url, path) =>
    new Promise((resolve, reject) => {
        throttle((url) => axios.get(url, { responseType: 'stream' }))(url)
            .then((response) => {
                if (response.status !== 200) {
                    return reject(new Error(response.statusText));
                }
                const writeStream = fs.createWriteStream(path);
                response.data.pipe(writeStream);
                writeStream.on('finish', () => {
                    writeStream.close();
                    resolve();
                });
            })
            .catch(reject);
    });

(async () => {
    console.log('Reading database');
    const db = JSON.parse(fs.readFileSync(DB_FILE_PATH));
    let lastPage = 1;
    for (let page = 1; page <= lastPage; page++) {
        console.log(`Processing page ${page} of forum`);
        const forumResponse = await throttle(axios.get)(`${BASE_URL}/?page=${page}`);
        const forumDom = new JSDOM(forumResponse.data);
        const forumDocument = forumDom.window.document;
        const forumPaginator = forumDocument.querySelector(SELECTORS.pagination);
        const forumPagesCount = forumPaginator ? +forumPaginator.textContent.trim().split(' ').at(-1) : 1;
        if (typeof forumPagesCount !== 'number') {
            throw new Error(`pagesCount is not a number: ${forumPagesCount}`);
        }
        lastPage = Math.max(lastPage, forumPagesCount);
        for (const link of forumDocument.querySelectorAll(SELECTORS.forumThreadLink)) {
            console.log(`Processing thread ${link.href} - ${link.textContent.trim()}`);
            const threadId = link.href.match(/topic\/(\d+)-/)[1];
            assert.ok(threadId);
            console.log(`Thread id = ${threadId}`);
            let lastThreadPage = 1;
            for (let threadPage = 1; threadPage <= lastThreadPage; threadPage++) {
                console.log(`Processing page ${threadPage} of thread ${threadId}`);
                const threadResponse = await throttle(axios.get)(link.href + '?page=' + threadPage);
                const threadDom = new JSDOM(threadResponse.data);
                const threadDocument = threadDom.window.document;
                const threadPaginator = threadDocument.querySelector(SELECTORS.pagination);
                const threadPagesCount = threadPaginator ? +threadPaginator.textContent.trim().split(' ').at(-1) : 1;
                const previouslyProcessedPagesCount = R.path([threadId, 'pagesProcessed'], db) || 0;
                assert.strictEqual(typeof previouslyProcessedPagesCount, 'number');
                if (previouslyProcessedPagesCount >= threadPagesCount) {
                    console.log('Thread has up-to-date data in database already, skipping');
                    break;
                }
                const thread = db[threadId] || {
                    pagesProcessed: 0,
                    posts: {},
                };
                assert.strictEqual(typeof threadPagesCount, 'number');
                lastThreadPage = Math.max(lastThreadPage, threadPagesCount);
                for (const postNode of threadDocument.querySelectorAll(SELECTORS.threadPost)) {
                    const postId = postNode.id.trim().split('_').at(-1);
                    assert.ok(postId);
                    const postAuthor = postNode.querySelector(SELECTORS.threadPost_author).textContent;
                    assert.ok(postAuthor);
                    console.log(`Replacing iframes in post ${postId}`);
                    for (const iframe of postNode.querySelectorAll(SELECTORS.threadPost_text_iframe)) {
                        const url = iframe.src;
                        const link = threadDocument.createElement('a');
                        link.href = url;
                        link.textContent = url;
                        iframe.replaceWith(link);
                    }
                    const postText = postNode.querySelector(SELECTORS.threadPost_text).textContent.trim();
                    assert.ok(postText);
                    const post = {
                        id: postId,
                        author: postAuthor,
                        text: postText,
                        attachments: [],
                    };
                    console.log(
                        `Processing post with id = ${postId}, author = ${postAuthor}, text = "${postText
                            .slice(0, 16)
                            .replace(/\r?\n/g, ' ')}..."`
                    );
                    for (const attachment of postNode.querySelectorAll(SELECTORS.threadPost_attachment)) {
                        let url = attachment.href;
                        if (url.startsWith('//')) {
                            url = 'https:' + url;
                        }
                        const title = attachment.textContent.trim();
                        const dlPath = `${ATTACHMENTS_DIR_PATH}/${threadId}_${postId}_${title}`;
                        console.log(`Downloading attachment ${url} to ${dlPath}`);
                        await downloadFile(url, dlPath);
                        post.attachments.push({ url, title });
                    }
                    thread.posts[postId] = post;
                }
                thread.pagesProcessed = threadPagesCount;
                db[threadId] = thread;
            }
            fs.writeFileSync(DB_FILE_PATH, JSON.stringify(db));
        }
        process.exit();
    }
})();
