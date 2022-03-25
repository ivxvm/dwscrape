import assert from 'assert';
import fs from 'fs';
import axios from 'axios';
import { JSDOM } from 'jsdom';
import * as R from 'ramda';
import pThrottle from 'p-throttle';

const BASE_URL = 'https://www.doomworld.com/forum/4-wads-mods';
const DB_FILE_PATH = './db.json';

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

const throttle = pThrottle({
    limit: 1,
    interval: 1000,
});

(async () => {
    console.log('Reading database');
    const db = JSON.parse(fs.readFileSync(DB_FILE_PATH));
    let lastPage = 1;
    for (let page = 1; page <= lastPage; page++) {
        console.log(`Processing page ${page} of forum`);
        const response = await throttle(axios.get)(`${BASE_URL}/?page=${page}`);
        const dom = new JSDOM(response.data);
        const document = dom.window.document;
        const paginator = document.querySelector(SELECTORS.pagination);
        const pagesCount = paginator ? +paginator.textContent.trim().split(' ').at(-1) : 1;
        if (typeof pagesCount !== 'number') {
            throw new Error(`pagesCount is not a number: ${pagesCount}`);
        }
        lastPage = Math.max(lastPage, pagesCount);
        for (const link of document.querySelectorAll(SELECTORS.forumThreadLink)) {
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
                        const url = attachment.href;
                        const title = attachment.textContent.trim();
                        console.log(`+ Attachment: ${url} - ${title}`);
                        post.attachments.push({ url, title });
                    }
                    thread.posts[postId] = post;
                }
                thread.pagesProcessed = threadPagesCount;
                db[threadId] = thread;
            }
            fs.writeFileSync(DB_FILE_PATH, JSON.stringify(db));
            process.exit();
        }
    }
})();
