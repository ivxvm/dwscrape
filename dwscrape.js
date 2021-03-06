import assert from 'assert';
import fs from 'fs';
import axios from 'axios';
import { JSDOM } from 'jsdom';
import * as R from 'ramda';
import pThrottle from 'p-throttle';
import util from 'util';
import checksum from 'checksum';

axios.interceptors.response.use(
    (response) => response,
    (error) => {
        console.log(`Request failed with status ${error.response.status} - ${error.response.statusText}`);
        return Promise.reject(error);
    }
);

const BASE_URL = 'https://www.doomworld.com/forum/4-wads-mods';
const DB_FILE_PATH = './db.json';
const ATTACHMENTS_DIR_PATH = './attachments';
const MAX_PAGES_TO_PROCESS = 5;

const SELECTORS = {
    pagination: '.ipsPagination_pageJump',
    forumThreadLink: '.ipsDataItem_title a[data-ipshover-target]',
    threadPost: '.cPost',
    threadPost_author: '.ipsComment_author .cAuthorPane_author',
    threadPost_text: '.cPost_contentWrap .ipsType_richText',
    threadPost_text_iframe: '.cPost_contentWrap .ipsType_richText iframe',
    threadPost_text_image: '.cPost_contentWrap .ipsType_richText img',
    threadPost_attachment: 'a.ipsAttachLink:not(.ipsAttachLink_image)',
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

console.log('Reading database');
const db = JSON.parse(fs.readFileSync(DB_FILE_PATH));

const saveDb = () => {
    console.log('Saving database to file');
    fs.writeFileSync(DB_FILE_PATH, JSON.stringify(db, null, 4));
};

setInterval(saveDb, 20_000);

(async () => {
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
        lastPage = Math.min(MAX_PAGES_TO_PROCESS, Math.max(lastPage, forumPagesCount));
        for (const link of forumDocument.querySelectorAll(SELECTORS.forumThreadLink)) {
            const threadTitle = link.textContent.trim();
            console.log(`Processing thread ${link.href} - ${threadTitle}`);
            const threadId = link.href.match(/topic\/(\d+)-/)[1];
            assert.ok(threadId);
            console.log(`Thread id = ${threadId}`);
            const thread = db[threadId] || {
                title: threadTitle,
                pagesProcessed: 1,
                posts: {},
            };
            if (thread.pagesProcessed > 1) {
                console.log(`Found thread records in database, continue processing from page ${thread.pagesProcessed}`);
            }
            let lastThreadPage = thread.pagesProcessed;
            for (let threadPage = thread.pagesProcessed; threadPage <= lastThreadPage; threadPage++) {
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
                assert.strictEqual(typeof threadPagesCount, 'number');
                lastThreadPage = Math.max(lastThreadPage, threadPagesCount);
                for (const postNode of threadDocument.querySelectorAll(SELECTORS.threadPost)) {
                    const postId = postNode.id.trim().split('_').at(-1);
                    assert.ok(postId);
                    const postAuthor = postNode.querySelector(SELECTORS.threadPost_author).textContent.trim();
                    assert.ok(postAuthor);
                    if (postNode.querySelector(SELECTORS.threadPost_text_iframe)) {
                        console.log(`Replacing iframes in post ${postId}`);
                        for (const iframe of postNode.querySelectorAll(SELECTORS.threadPost_text_iframe)) {
                            const url = iframe.src;
                            const link = threadDocument.createElement('a');
                            link.href = url;
                            link.textContent = url;
                            link.dataset.replacement = true;
                            iframe.replaceWith(link);
                        }
                    }
                    if (postNode.querySelector(SELECTORS.threadPost_text_image)) {
                        console.log(`Replacing images in post ${postId}`);
                        for (const image of postNode.querySelectorAll(SELECTORS.threadPost_text_image)) {
                            const url = image.src;
                            const link = threadDocument.createElement('a');
                            link.href = url;
                            link.textContent = url;
                            link.dataset.replacement = true;
                            image.replaceWith(link);
                        }
                    }
                    const postText = postNode.querySelector(SELECTORS.threadPost_text).textContent.trim();
                    const post = {
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
                        if (attachment.textContent.trim() === '' || attachment.querySelector('[data-replacement]')) {
                            console.log(`Bad attachment ${attachment.href}, skipping`);
                            continue;
                        }
                        let url = attachment.href;
                        if (url.startsWith('//')) {
                            url = 'https:' + url;
                        }
                        const title = attachment.textContent.trim();
                        const dlPath = `${ATTACHMENTS_DIR_PATH}/${threadId}_${postId}_${title}`;
                        try {
                            console.log(`Downloading attachment ${url}`);
                            await downloadFile(url, dlPath + '_temp');
                            let renamedFilePath = null;
                            let oldFileChecksum = null;
                            if (fs.existsSync(dlPath)) {
                                console.log('Corresponding attachment file already exists, renaming old file');
                                renamedFilePath = `${ATTACHMENTS_DIR_PATH}/${threadId}_${postId}_${Date.now()}_${title}`;
                                oldFileChecksum = await util.promisify(checksum.file)(dlPath);
                                fs.renameSync(dlPath, renamedFilePath);
                                post.attachments = post.attachments.map((att) =>
                                    att.path === dlPath ? { ...att, path: renamedFilePath } : att
                                );
                            }
                            if (renamedFilePath) {
                                const newFileChecksum = await util.promisify(checksum.file)(dlPath);
                                if (newFileChecksum === oldFileChecksum) {
                                    console.log('Old and new file checksum are the same, removing old file');
                                    fs.rmSync(renamedFilePath);
                                }
                            }
                            console.log(`Renaming temp file to ${dlPath}`);
                            fs.renameSync(dlPath + '_temp', dlPath);
                            post.attachments.push({ url, title, path: dlPath });
                        } catch (error) {
                            console.log('Download failed, skipping');
                        }
                    }
                    thread.posts[postId] = post;
                }
                thread.pagesProcessed = threadPage;
                db[threadId] = thread;
            }
            console.log(`Finished processing thread ${threadId}`);
        }
    }
    saveDb();
    process.exit();
})();
