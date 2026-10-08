// 页面模板 - 使用 text import 避免嵌套模板字面量问题
import themeResourcesHtml from './theme-resources.html';
import loginPageHtml from './loginPage.html';
import adminPageHtml from './adminPage.html';
import configPageHtml from './configPage.html';
import dashboardPageHtml from './dashboardPage.html';
import notifyLogsPageHtml from './notifyLogsPage.html';
import subscriptionHistoryPageHtml from './subscriptionHistoryPage.html';
import databasePageHtml from './databasePage.html';
import baseDatabasePanel from './baseDatabasePanel.html';
import baseDatabaseScript from './baseDatabaseScript.html';

// themeResources 需要注入到每个页面模板中
function injectTheme(html) {
  return html.replace(/\$\{themeResources\}/g, themeResourcesHtml);
}

const loginPage = injectTheme(loginPageHtml);
const adminPage = injectTheme(adminPageHtml);
const configPage = injectTheme(configPageHtml);
const notifyLogsPage = injectTheme(notifyLogsPageHtml);
const subscriptionHistoryPage = injectTheme(subscriptionHistoryPageHtml);
const databasePage = injectTheme(databasePageHtml.replace('${baseDatabasePanel}', () => baseDatabasePanel).replace('</body>', () => baseDatabaseScript+'</body>'));

function dashboardPage() {
  return injectTheme(dashboardPageHtml);
}

export { loginPage, adminPage, configPage, dashboardPage, notifyLogsPage, databasePage, subscriptionHistoryPage };
